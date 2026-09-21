"use client";

import React from "react";

import { SaveButton } from "@/components/admin/shared/SaveButton";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { BUILT_IN_OAUTH_CONNECTORS } from "@/lib/credentials/built-in-oauth-connectors";

interface OAuthConnectorMetadata {
  id: string;
  name: string;
  provider: string;
  clientId: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirectUri: string;
  enabled?: boolean;
  clientSecretConfigured?: boolean;
  pkce?: boolean;
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const json = (await response.json()) as { data: T };
  return json.data;
}

export function OAuthConnectorAdminPanel({ readOnly = false }: { readOnly?: boolean }) {
  const [connectors, setConnectors] = React.useState<OAuthConnectorMetadata[]>([]);
  const [form, setForm] = React.useState({
    name: "",
    provider: "",
    clientId: "",
    clientSecret: "",
    authorizationUrl: "",
    tokenUrl: "",
    scopes: "",
    redirectUri: "",
    pkce: false,
  });
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editingConnector, setEditingConnector] = React.useState<OAuthConnectorMetadata | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const loadConnectors = React.useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/admin/credentials/oauth-connectors");
      if (!response.ok) {
        throw new Error("Could not load OAuth connectors");
      }
      setConnectors(await parseApiResponse<OAuthConnectorMetadata[]>(response));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load OAuth connectors");
    }
  }, []);

  React.useEffect(() => {
    void loadConnectors();
  }, [loadConnectors]);

  const updateForm = (field: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
  };

  const applyBuiltInTemplate = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const descriptor = BUILT_IN_OAUTH_CONNECTORS.find(
      (candidate) => candidate.provider === event.target.value,
    );
    if (!descriptor) return;
    setForm((current) => ({
      ...current,
      name: descriptor.name,
      provider: descriptor.provider,
      authorizationUrl: descriptor.authorizationUrl,
      tokenUrl: descriptor.tokenUrl,
      scopes: descriptor.scopes.join(" "),
    }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (readOnly) return;
    const body = {
      ...form,
      scopes: form.scopes
        .split(/[,\s]+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
    };
    const url = editingConnector
      ? `/api/admin/credentials/oauth-connectors/${editingConnector.id}`
      : "/api/admin/credentials/oauth-connectors";
    const method = editingConnector ? "PUT" : "POST";
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      setError("Could not save OAuth connector");
      return;
    }
    const connector = await parseApiResponse<OAuthConnectorMetadata>(response);
    if (editingConnector) {
      setConnectors((current) =>
        current.map((c) => (c.id === connector.id ? connector : c)).sort((a, b) => a.name.localeCompare(b.name)),
      );
    } else {
      setConnectors((current) => [...current, connector].sort((a, b) => a.name.localeCompare(b.name)));
    }
    setForm({
      name: "",
      provider: "",
      clientId: "",
      clientSecret: "",
      authorizationUrl: "",
      tokenUrl: "",
      scopes: "",
      redirectUri: "",
      pkce: false,
    });
    setEditingConnector(null);
    setCreateOpen(false);
  };

  const handleEdit = (connector: OAuthConnectorMetadata) => {
    if (readOnly) return;
    setEditingConnector(connector);
    setForm({
      name: connector.name,
      provider: connector.provider,
      clientId: connector.clientId,
      clientSecret: "",
      authorizationUrl: connector.authorizationUrl,
      tokenUrl: connector.tokenUrl,
      scopes: connector.scopes.join(" "),
      redirectUri: connector.redirectUri,
      pkce: connector.pkce ?? false,
    });
    setCreateOpen(true);
  };

  const handleDelete = async (connector: OAuthConnectorMetadata) => {
    if (readOnly) return;
    if (!confirm(`Delete "${connector.name}"? This will disable it and cannot be undone.`)) return;
    const response = await fetch(`/api/admin/credentials/oauth-connectors/${connector.id}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      setError(`Could not delete ${connector.name}`);
      return;
    }
    setConnectors((current) => current.filter((c) => c.id !== connector.id));
  };

  const handleEnabledChange = async (connector: OAuthConnectorMetadata, enabled: boolean) => {
    if (readOnly) return;
    const response = await fetch(`/api/admin/credentials/oauth-connectors/${connector.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: enabled ? "enable" : "disable" }),
    });
    if (!response.ok) {
      setError(`Could not ${enabled ? "enable" : "disable"} ${connector.name}`);
      return;
    }
    setConnectors((current) =>
      current.map((candidate) =>
        candidate.id === connector.id ? { ...candidate, enabled } : candidate,
      ),
    );
  };

  return (
    <section className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Admin OAuth Connector Configuration</h2>
          <p className="text-sm text-muted-foreground">
            Register standard OAuth 2.0 connectors. Client secrets are stored as encrypted
            credential payloads and are never shown here.
          </p>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)} disabled={readOnly}>
          Add OAuth Provider
        </Button>
      </div>

      {createOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={editingConnector ? "Edit OAuth Provider" : "Add OAuth Provider"}
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
        >
          <form
            onSubmit={handleSubmit}
            className="w-full max-w-3xl rounded-lg border border-border bg-card p-5 shadow-xl space-y-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-medium">{editingConnector ? "Edit OAuth Provider" : "Add OAuth Provider"}</h2>
                <p className="text-sm text-muted-foreground">
                  Configure a standard authorization-code connector for user connections.
                </p>
              </div>
              <button
                type="button"
                className="text-sm text-muted-foreground"
                onClick={() => { setCreateOpen(false); setEditingConnector(null); }}
              >
                Close
              </button>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1 text-sm md:col-span-2">
                <span>Built-in template</span>
                <Select
                  className="w-full rounded-md border border-input bg-background px-3 py-2"
                  defaultValue=""
                  onChange={applyBuiltInTemplate}
                >
                  <option value="">Custom OAuth provider</option>
                  {BUILT_IN_OAUTH_CONNECTORS.map((descriptor) => (
                    <option key={descriptor.provider} value={descriptor.provider}>
                      {descriptor.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="space-y-1 text-sm">
                <span>Display name</span>
                <input className="w-full rounded-md border border-input bg-background px-3 py-2" value={form.name} onChange={updateForm("name")} required />
              </label>
              <label className="space-y-1 text-sm">
                <span>Provider</span>
                <input className="w-full rounded-md border border-input bg-background px-3 py-2" value={form.provider} onChange={updateForm("provider")} required />
              </label>
              <label className="space-y-1 text-sm">
                <span>Client ID</span>
                <input className="w-full rounded-md border border-input bg-background px-3 py-2" value={form.clientId} onChange={updateForm("clientId")} required />
              </label>
              {!form.pkce && (
                <label className="space-y-1 text-sm">
                  <span>Client secret</span>
                  <input className="w-full rounded-md border border-input bg-background px-3 py-2" value={form.clientSecret} onChange={updateForm("clientSecret")} required type="password" />
                </label>
              )}
              <label className="flex items-center gap-2 text-sm md:col-span-2">
                <input
                  type="checkbox"
                  checked={form.pkce}
                  onChange={(e) => setForm((current) => ({ ...current, pkce: e.target.checked, clientSecret: "" }))}
                />
                <span>Public client (PKCE only — no client secret)</span>
              </label>
              <label className="space-y-1 text-sm">
                <span>Authorization URL</span>
                <input className="w-full rounded-md border border-input bg-background px-3 py-2" value={form.authorizationUrl} onChange={updateForm("authorizationUrl")} required />
              </label>
              <label className="space-y-1 text-sm">
                <span>Token URL</span>
                <input className="w-full rounded-md border border-input bg-background px-3 py-2" value={form.tokenUrl} onChange={updateForm("tokenUrl")} required />
              </label>
              <label className="space-y-1 text-sm md:col-span-2">
                <span>Scopes</span>
                <input className="w-full rounded-md border border-input bg-background px-3 py-2" value={form.scopes} onChange={updateForm("scopes")} placeholder="offline_access read_user" />
              </label>
              <label className="space-y-1 text-sm md:col-span-2">
                <span>Redirect URI</span>
                <input className="w-full rounded-md border border-input bg-background px-3 py-2" value={form.redirectUri} onChange={updateForm("redirectUri")} required />
              </label>
            </div>
            <SaveButton type="submit" saving={false} ariaLabel="Save connector" />
          </form>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="rounded-lg border border-border bg-card">
        {connectors.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No OAuth connectors configured.</p>
        ) : (
          <ul className="divide-y divide-border">
            {connectors.map((connector) => (
              <li key={connector.id} className="flex items-start justify-between gap-4 p-4">
                <div>
                  <p className="font-medium">{connector.name}</p>
                  <p className="text-xs text-muted-foreground">{connector.provider} / {connector.clientId}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <span className="inline-block rounded bg-muted px-2 py-1 text-xs">
                      {connector.pkce ? "public client (PKCE)" : connector.clientSecretConfigured ? "client secret configured" : "client secret missing"}
                    </span>
                    <span className="inline-block rounded bg-muted px-2 py-1 text-xs">
                      {connector.enabled === false ? "disabled" : "enabled"}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Edit ${connector.name}`}
                    onClick={() => handleEdit(connector)}
                    disabled={readOnly}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`${connector.enabled === false ? "Enable" : "Disable"} ${connector.name}`}
                    onClick={() => void handleEnabledChange(connector, connector.enabled === false)}
                    disabled={readOnly}
                  >
                    {connector.enabled === false ? "Enable" : "Disable"}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    aria-label={`Delete ${connector.name}`}
                    onClick={() => void handleDelete(connector)}
                    disabled={readOnly}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
