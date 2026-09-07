"use client";

// assisted-by Codex Codex-sonnet-4-6

import { Eye, EyeOff, Info, RefreshCw, Share2, Trash2, X } from "lucide-react";
import React from "react";

import { Button } from "@/components/ui/button";
import { WorkspacePageActions } from "@/components/layout/WorkspacePageActions";

import { principalLabel, SecretProtectionBadge } from "./SecretProtectionDetails";
import { SecretSharingPanel } from "./SecretSharingPanel";

interface SecretMetadata {
  id: string;
  name: string;
  type: string;
  owner?: { type: string; id: string; email?: string; name?: string; displayName?: string };
  createdBy?: {
    type: "user" | "service_account";
    id: string;
    email?: string;
    name?: string;
    displayName?: string;
  };
  description?: string;
  maskedPreview: string;
  sharedWithTeams?: string[];
  usage?: Array<{ type: string; id: string; name: string; location: string; detail?: string }>;
  storage?: {
    metadataCollection: string;
    payloadCollection: string;
    encryption: string;
    plaintextReadableByBrowser: false;
    valuePreviewAvailable: true;
  };
  createdAt?: string;
  updatedAt?: string;
  rotatedAt?: string;
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const json = (await response.json()) as { data: T };
  return json.data;
}

function formatDate(value?: string): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return date.toLocaleString();
}

export function SecretsManager() {
  const [secrets, setSecrets] = React.useState<SecretMetadata[]>([]);
  const [name, setName] = React.useState("");
  const [secretValue, setSecretValue] = React.useState("");
  const [secretValueVisible, setSecretValueVisible] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createOrgLevel, setCreateOrgLevel] = React.useState(false);
  const [sharingSecretId, setSharingSecretId] = React.useState<string | null>(null);
  const [detailsSecretId, setDetailsSecretId] = React.useState<string | null>(null);
  const [rotatingSecretId, setRotatingSecretId] = React.useState<string | null>(null);
  const [rotateValue, setRotateValue] = React.useState("");
  const [rotateValueVisible, setRotateValueVisible] = React.useState(false);
  const [savingRotateSecretId, setSavingRotateSecretId] = React.useState<string | null>(null);
  const [pendingDeleteSecretId, setPendingDeleteSecretId] = React.useState<string | null>(null);
  const [deletingSecretId, setDeletingSecretId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const detailsSecret = React.useMemo(
    () => secrets.find((secret) => secret.id === detailsSecretId) ?? null,
    [secrets, detailsSecretId],
  );
  const detailsSharedTeams = React.useMemo(
    () => detailsSecret?.sharedWithTeams?.filter(Boolean) ?? [],
    [detailsSecret],
  );

  const loadSecrets = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/credentials/secrets");
      if (!response.ok) {
        throw new Error("Could not load secrets");
      }
      setSecrets(await parseApiResponse<SecretMetadata[]>(response));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load secrets");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadSecrets();
  }, [loadSecrets]);

  const closeCreateDialog = () => {
    setName("");
    setSecretValue("");
    setSecretValueVisible(false);
    setCreateOrgLevel(false);
    setCreateOpen(false);
  };

  const handleCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const body: Record<string, string> = {
      name,
      type: "bearer_token",
      value: secretValue,
    };
    if (createOrgLevel) {
      body.ownerType = "organization";
    }
    const response = await fetch("/api/credentials/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const json = await response.json().catch(() => null) as { error?: string } | null;
      setError(json?.error ?? "Could not save secret");
      return;
    }

    const created = await parseApiResponse<SecretMetadata>(response);
    setSecrets((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
    closeCreateDialog();
  };

  const handleDelete = async (secret: SecretMetadata) => {
    setDeletingSecretId(secret.id);
    setError(null);
    try {
      const response = await fetch(`/api/credentials/secrets/${secret.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("Could not delete secret");
      }
      setSecrets((current) => current.filter((item) => item.id !== secret.id));
      if (sharingSecretId === secret.id) {
        setSharingSecretId(null);
      }
      if (rotatingSecretId === secret.id) {
        closeRotatePanel();
      }
      if (detailsSecretId === secret.id) {
        setDetailsSecretId(null);
      }
      if (pendingDeleteSecretId === secret.id) {
        setPendingDeleteSecretId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete secret");
    } finally {
      setDeletingSecretId(null);
    }
  };

  const closeRotatePanel = () => {
    setRotatingSecretId(null);
    setRotateValue("");
    setRotateValueVisible(false);
  };

  const openRotatePanel = (secretId: string) => {
    if (rotatingSecretId === secretId) {
      closeRotatePanel();
      return;
    }
    setSharingSecretId(null);
    setPendingDeleteSecretId(null);
    setRotatingSecretId(secretId);
    setRotateValue("");
    setRotateValueVisible(false);
  };

  const handleRotate = async (event: React.FormEvent<HTMLFormElement>, secret: SecretMetadata) => {
    event.preventDefault();
    setSavingRotateSecretId(secret.id);
    setError(null);
    try {
      const response = await fetch(`/api/credentials/secrets/${secret.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "rotate",
          value: rotateValue,
        }),
      });
      if (!response.ok) {
        throw new Error("Could not rotate secret");
      }
      const rotated = await parseApiResponse<SecretMetadata>(response);
      setSecrets((current) =>
        current
          .map((item) => (item.id === secret.id ? rotated : item))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      closeRotatePanel();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rotate secret");
    } finally {
      setSavingRotateSecretId(null);
    }
  };

  const updateSecretSharing = (secretId: string, teamIds: string[]) => {
    setSecrets((current) =>
      current.map((secret) =>
        secret.id === secretId ? { ...secret, sharedWithTeams: teamIds } : secret,
      ),
    );
  };

  return (
    <section className="space-y-6">
      <WorkspacePageActions>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          Add Secret
        </Button>
      </WorkspacePageActions>

      {createOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Add Secret"
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
        >
          <form
            onSubmit={handleCreate}
            className="w-full max-w-2xl rounded-lg border border-border bg-card p-5 shadow-xl space-y-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-medium">Add Secret</h2>
                <p className="text-sm text-muted-foreground">
                  The value is saved once, encrypted, and hidden after you submit it.
                </p>
              </div>
              <button
                type="button"
                className="text-sm text-muted-foreground"
                onClick={closeCreateDialog}
              >
                Close
              </button>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label htmlFor="new-secret-name" className="space-y-1 text-sm">
                <span>Name</span>
                <input
                  id="new-secret-name"
                  className="w-full rounded-md border border-input bg-background px-3 py-2"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </label>
              <div className="space-y-1 text-sm">
                <label htmlFor="new-secret-value">Secret value</label>
                <div className="relative">
                  <input
                    id="new-secret-value"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 pr-11"
                    value={secretValue}
                    onChange={(event) => setSecretValue(event.target.value)}
                    required
                    type={secretValueVisible ? "text" : "password"}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={
                      secretValueVisible
                        ? "Hide secret value before saving"
                        : "Show secret value before saving"
                    }
                    title={secretValueVisible ? "Hide secret value" : "Show secret value"}
                    className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setSecretValueVisible((current) => !current)}
                  >
                    {secretValueVisible ? (
                      <EyeOff className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden="true" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                checked={createOrgLevel}
                onChange={(e) => setCreateOrgLevel(e.target.checked)}
                className="h-4 w-4 rounded border-input accent-teal-500"
              />
              <span>
                Save as organization secret
                <span className="ml-1 text-xs text-muted-foreground">(available to all org members, requires admin)</span>
              </span>
            </label>
            <Button type="submit">Save Secret</Button>
          </form>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading ? (
            <p className="text-sm text-muted-foreground">Loading secrets...</p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card/80 shadow-sm">
          {secrets.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No secrets yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {secrets.map((secret) => (
                <li key={secret.id} className="p-4 transition-colors hover:bg-muted/20">
                  <div className="grid items-center gap-4 md:grid-cols-[minmax(0,1fr)_auto_auto]">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{secret.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {secret.type}
                        {secret.owner?.type === 'organization' && (
                          <span className="ml-2 rounded-full bg-blue-500/10 px-2 py-0.5 text-blue-300">
                            Organization
                          </span>
                        )}
                        {secret.owner?.type !== 'organization' && (secret.sharedWithTeams?.length ?? 0) > 0 && (
                          <span className="ml-2 rounded-full bg-teal-500/10 px-2 py-0.5 text-teal-300">
                            Team access enabled
                          </span>
                        )}
                      </p>
                    </div>
                    <code className="w-fit rounded bg-muted px-2 py-1 text-xs">
                      Preview {secret.maskedPreview}
                    </code>
                    <div className="flex items-center justify-end gap-1">
                      {pendingDeleteSecretId === secret.id ? (
                        <div className="flex items-center gap-2 rounded-full border border-destructive/20 bg-destructive/10 px-2 py-1">
                          <span className="text-xs font-medium text-destructive">
                            Delete {secret.name}?
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                            disabled={deletingSecretId === secret.id}
                            onClick={() => setPendingDeleteSecretId(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            aria-label={`Confirm delete ${secret.name}`}
                            className="h-7 bg-destructive px-2 text-xs text-destructive-foreground hover:bg-destructive/90"
                            disabled={deletingSecretId === secret.id}
                            onClick={() => void handleDelete(secret)}
                          >
                            Delete
                          </Button>
                        </div>
                      ) : (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`View details for ${secret.name}`}
                            title={`View details for ${secret.name}`}
                            onClick={() => setDetailsSecretId(secret.id)}
                          >
                            <Info className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Rotate ${secret.name}`}
                            title={`Rotate ${secret.name}`}
                            onClick={() => openRotatePanel(secret.id)}
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Share ${secret.name}`}
                            title={`Share ${secret.name}`}
                            onClick={() =>
                              setSharingSecretId((current) => (current === secret.id ? null : secret.id))
                            }
                          >
                            <Share2 className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete ${secret.name}`}
                            title={`Delete ${secret.name}`}
                            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            disabled={deletingSecretId === secret.id}
                            onClick={() => setPendingDeleteSecretId(secret.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  {rotatingSecretId === secret.id && (
                    <form
                      role="region"
                      aria-label={`${secret.name} rotation`}
                      className="mt-4 rounded-lg border border-border/70 bg-background/55 p-4"
                      onSubmit={(event) => void handleRotate(event, secret)}
                    >
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-teal-300">
                            Rotate secret
                          </p>
                          <h3 className="text-sm font-semibold">Update {secret.name}</h3>
                          <p className="mt-1 text-sm text-muted-foreground">
                            Paste the new value. You can peek before saving; after rotation only a masked preview is shown.
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Close rotation panel"
                          onClick={closeRotatePanel}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                      <div className="flex flex-col gap-3 md:flex-row md:items-end">
                        <div className="min-w-0 flex-1 space-y-1 text-sm">
                          <label htmlFor={`rotate-secret-value-${secret.id}`}>New secret value</label>
                          <div className="relative">
                            <input
                              id={`rotate-secret-value-${secret.id}`}
                              className="w-full rounded-md border border-input bg-background px-3 py-2 pr-11"
                              value={rotateValue}
                              onChange={(event) => setRotateValue(event.target.value)}
                              required
                              type={rotateValueVisible ? "text" : "password"}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={
                                rotateValueVisible
                                  ? "Hide new secret value before saving"
                                  : "Show new secret value before saving"
                              }
                              title={rotateValueVisible ? "Hide new value" : "Show new value"}
                              className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                              onClick={() => setRotateValueVisible((current) => !current)}
                            >
                              {rotateValueVisible ? (
                                <EyeOff className="h-4 w-4" aria-hidden="true" />
                              ) : (
                                <Eye className="h-4 w-4" aria-hidden="true" />
                              )}
                            </Button>
                          </div>
                        </div>
                        <Button type="submit" disabled={savingRotateSecretId === secret.id}>
                          {savingRotateSecretId === secret.id ? "Saving..." : "Save new value"}
                        </Button>
                      </div>
                    </form>
                  )}
                  {sharingSecretId === secret.id && (
                    <div
                      role="region"
                      aria-label={`${secret.name} team access`}
                      className="mt-4 rounded-lg border border-border/70 bg-background/55 p-4"
                    >
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-teal-300">
                            Team access
                          </p>
                <h3 className="text-sm font-semibold">Share {secret.name}</h3>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Close sharing panel"
                          onClick={() => setSharingSecretId(null)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                      <SecretSharingPanel
                        secretId={secret.id}
                        sharedWithTeams={secret.sharedWithTeams ?? []}
                        onSharingChange={(teamIds) => updateSecretSharing(secret.id, teamIds)}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {detailsSecret && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${detailsSecret.name} details`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
        >
          <div className="flex max-h-[min(42rem,calc(100vh-2rem))] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-border p-5">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-teal-300">
                  Secret details
                </p>
                <h2 className="mt-1 text-lg font-semibold">{detailsSecret.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Details only. The saved value stays protected; this preview is masked.
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close secret details"
                onClick={() => setDetailsSecretId(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-4 overflow-y-auto p-5 text-sm">
              <div className="grid gap-3 rounded-lg border border-border/70 bg-background/45 p-3 md:grid-cols-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Created by
                  </p>
                  <p>{principalLabel(detailsSecret.createdBy)}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Created
                  </p>
                  <p>{formatDate(detailsSecret.createdAt)}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Shared with
                  </p>
                  {detailsSharedTeams.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {detailsSharedTeams.map((teamId) => (
                        <span
                          key={teamId}
                          className="rounded-full bg-teal-500/10 px-2 py-0.5 text-xs text-teal-300"
                        >
                          {teamId}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1 text-muted-foreground">Not shared with teams</p>
                  )}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Masked preview
                  </p>
                  <code className="mt-1 inline-flex rounded bg-muted px-2 py-1 text-xs">
                    {detailsSecret.maskedPreview}
                  </code>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Credential type
                  </p>
                  <p>{detailsSecret.type}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Last rotated
                  </p>
                  <p>{formatDate(detailsSecret.rotatedAt)}</p>
                </div>
              </div>

              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Used by</p>
                {(detailsSecret.usage?.length ?? 0) > 0 ? (
                  <div className="mt-2 space-y-1">
                    {detailsSecret.usage?.map((item) => (
                      <p key={`${item.type}:${item.id}:${item.detail ?? ""}`} className="text-muted-foreground">
                        {item.name} · {item.location}
                        {item.detail ? ` · ${item.detail}` : ""}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-muted-foreground">Not used by any configured service yet</p>
                )}
              </div>

              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Security</p>
                <SecretProtectionBadge storage={detailsSecret.storage} />
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
